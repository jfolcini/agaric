/**
 * useSyncEvents — listens to Tauri sync events and updates the sync store.
 *
 * Handles two event types from the Rust backend:
 * - sync:complete — resets to idle, shows toast, reloads blocks if data changed
 * - sync:error — sets error state, shows error toast
 *
 * Per-state-transition progress (`sync:progress` in Phase 1) was dropped
 * by PEND-06 Phase 2 — `useSyncTrigger` now consumes the Channel<T>
 * `onProgress` callback set up by `startSync` for that. The two event
 * listeners that remain carry post-sync side effects (toast / page reload
 * on complete; error toast on failure) that the channel-stream callback
 * does not duplicate; if those side effects move to the channel path in a
 * later cleanup, this hook can shrink further.
 *
 * No-op in browser mode (when Tauri APIs are unavailable).
 * Call once at app root (App.tsx).
 *
 * Resolves issues #276, #386, #378.
 */

import { announce } from '@/lib/announcer'
import { recordGraphStructureChange } from '@/lib/graph-structure-events'
import { i18n } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { forEachPageStore } from '@/stores/page-blocks'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import { useSyncStore } from '@/stores/sync'
import { useUndoStore } from '@/stores/undo'

import { useTauriEventListener } from './useTauriEventListener'

/** Payload shapes from the Rust backend sync_events.rs */
export interface SyncCompletePayload {
  type: 'complete'
  remote_device_id: string
  ops_received: number
  ops_sent: number
  /**
   * #1071 — deduped set of owning *page* ids (page-root block ids) touched by
   * the ops applied during this sync session. When present and non-empty, the
   * handler reloads ONLY the mounted page stores whose id is in this set and
   * runs the resolve preload (a changed page's / tag's title may have moved).
   *
   * Optional for backward compatibility: a peer on the old protocol (or the
   * snapshot-catch-up path, which reimports a whole space) omits it / sends an
   * empty array, and the handler falls back to reloading EVERY mounted store
   * plus a full preload. The field is NOT specta-exported — it rides on the
   * `sync:complete` Tauri event (`SyncEvent::Complete`), which is serialize-
   * only, so this hand-written shape is the single source of truth for it.
   */
  changed_page_ids?: string[]
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

  // PEND-06 Phase 2 — `sync:progress` listener removed. The
  // Channel<SyncProgressUpdate> opened by `startSync` is now the
  // canonical source for per-state-transition progress; see
  // `useSyncTrigger` for the consumer.
  useTauriEventListener<SyncCompletePayload>(
    'sync:complete',
    (event) => {
      try {
        const { ops_received, ops_sent, changed_page_ids } = event.payload
        const store = useSyncStore.getState()
        store.setState('idle')
        store.setOpsReceived(ops_received)
        store.setOpsSent(ops_sent)
        store.updateLastSynced(new Date().toISOString())

        // Show toast notification
        if (ops_received > 0) {
          notify.success(i18n.t('sync.opsReceived', { count: ops_received }))
          announce(i18n.t('announce.syncOpsReceived', { count: ops_received }))
        }

        // Reload blocks if we received ops (data changed).
        //
        // #1071 — TARGETED invalidation. The backend now threads the set of
        // page-root ids its applied ops actually touched
        // (`changed_page_ids`). When that set is present and non-empty we
        // reload + re-anchor ONLY the mounted page stores in the set, and
        // run the resolve preload once (a changed page's / tag's title may
        // have moved). This replaces the old O(mounted-pages) fan-out where
        // one remote op touching one block reloaded every visible BlockTree
        // (up to ~30 DaySection stores in the monthly journal).
        //
        // FALLBACK (mandatory backward-compat): when the field is absent or
        // empty — an older backend, a peer on the old protocol, or the
        // snapshot-catch-up path that reimports a whole space — reload ALL
        // mounted stores + a full preload, exactly the pre-#1071 behaviour.
        // When in doubt we fall back rather than risk a missed update.
        if (ops_received > 0) {
          const reanchorUndo = useUndoStore.getState().reanchorAfterRemoteOps
          const targeted =
            Array.isArray(changed_page_ids) && changed_page_ids.length > 0
              ? new Set(changed_page_ids)
              : null

          forEachPageStore((pageId, pageStore) => {
            // In targeted mode, skip stores whose page wasn't touched by the
            // applied ops — they cannot have changed, so reloading them is
            // pure waste. In fallback mode (`targeted == null`) reload every
            // store, as before.
            if (targeted && !targeted.has(pageId)) return
            // #731 — re-anchor this page's positional undo state BEFORE the
            // reload. The remote ops just applied shifted the backend op-log
            // indexing that `undoDepth` addresses; without this reset the next
            // Ctrl+Z would reverse the wrong op, and stale redoStack OpRefs
            // could target ops the remote write superseded. Resetting to depth
            // 0 / empty redo is the safe re-anchor (a fresh undo re-reads the
            // newest op). Keyed by the same pageId the block reload uses.
            reanchorUndo(pageId)
            pageStore.getState().load()
          })

          // Resolve-cache preload. In targeted mode the set is non-empty
          // here (the `ops_received > 0` + non-empty guard), so a page/tag
          // title may have changed — run the preload. In fallback mode
          // (unknown change scope) we always preload. Either way the
          // condition is "we had something to reconcile", which is true in
          // both branches inside this `ops_received > 0` block.
          //
          // FEAT-3p7 — preload takes the active space id so the post-sync
          // re-fetch only re-keys current-space pages into the cache.
          // Foreign-space rows synced from the peer never land in the cache
          // here; they are filtered by the next BlockTree-level batchResolve
          // and rendered as broken-link chips.
          const refreshSpaceId = useSpaceStore.getState().currentSpaceId
          useResolveStore.getState().preload(refreshSpaceId ?? undefined, true)

          // #1530 — remote ops also change the page-link graph topology (a
          // synced page creation or a `[[link]]` edit). Bump the graph-structure
          // signal so a mounted GraphView refetches its cache (stale-while-
          // revalidate) instead of serving stale nodes/edges until the TTL. The
          // signal is module-level, so a mount that happens after this sync —
          // while GraphView was unmounted — still observes the bump.
          recordGraphStructureChange()
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
        notify.error(i18n.t('sync.failed', { message }), { id: 'sync-error' })
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
