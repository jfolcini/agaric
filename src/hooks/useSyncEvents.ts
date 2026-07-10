/**
 * useSyncEvents — listens to Tauri sync events and updates the sync store.
 *
 * Handles two event types from the Rust backend:
 * - sync:complete — resets to idle, shows toast, reloads blocks if data changed
 * - sync:error — sets error state, shows error toast
 *
 * Per-state-transition progress (`sync:progress` in Phase 1) was dropped
 * By Phase 2 — `useSyncTrigger` now consumes the Channel<T>
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

/**
 * #2505 — payload of the `blocks:changed` event (Rust `BlocksChangedEvent`,
 * `src-tauri/src/sync_events.rs`). Emitted after an out-of-band local write —
 * today an MCP read-write tool — commits, so open views reload the touched
 * pages. `changed_page_ids` carries the IDENTICAL semantics as
 * `SyncCompletePayload.changed_page_ids` (#1071), which is what lets this
 * handler reuse the exact same `reloadChangedPageStores` targeted-reload path.
 * Serialize-only on the Rust side (rides the Tauri event, not specta), so this
 * hand-written shape is the single source of truth.
 */
export interface BlocksChangedPayload {
  changed_page_ids?: string[]
}

/**
 * #1071 / #2505 — the shared targeted page-store reload. Given the set of
 * owning-page ids touched by an out-of-band write (a remote sync session or an
 * MCP write), reload + undo-re-anchor ONLY the mounted page stores whose id is
 * in the set, then run one resolve-cache preload and bump the graph-structure
 * signal.
 *
 * FALLBACK: when `changedPageIds` is absent or empty (an older peer, the
 * snapshot-catch-up path, or an MCP write whose block had no resolvable page
 * ancestor) reload EVERY mounted store plus a full preload — when in doubt we
 * fall back rather than risk a missed update.
 */
function reloadChangedPageStores(changedPageIds: string[] | undefined): void {
  const reanchorUndo = useUndoStore.getState().reanchorAfterRemoteOps
  const targeted =
    Array.isArray(changedPageIds) && changedPageIds.length > 0 ? new Set(changedPageIds) : null

  forEachPageStore((pageId, pageStore) => {
    // In targeted mode, skip stores whose page wasn't touched — they cannot
    // have changed, so reloading them is pure waste. In fallback mode
    // (`targeted == null`) reload every store.
    if (targeted && !targeted.has(pageId)) return
    // #731 — re-anchor this page's positional undo state BEFORE the reload.
    // The out-of-band ops just applied shifted the backend op-log indexing
    // that `undoDepth` addresses; without this reset the next Ctrl+Z would
    // reverse the wrong op. Keyed by the same pageId the block reload uses.
    reanchorUndo(pageId)
    pageStore.getState().load()
  })

  // Resolve-cache preload — a changed page's / tag's title may have moved.
  // Takes the active space id so the re-fetch only re-keys current-space pages.
  const refreshSpaceId = useSpaceStore.getState().currentSpaceId
  useResolveStore.getState().preload(refreshSpaceId ?? undefined, true)

  // #1530 — out-of-band ops also change the page-link graph topology; bump the
  // graph-structure signal so a mounted GraphView refetches (stale-while-
  // revalidate) instead of serving stale nodes/edges until the TTL.
  recordGraphStructureChange()
}

/** Map backend state strings to frontend SyncState enum. */
export function mapBackendState(backendState: string): 'idle' | 'syncing' | 'error' {
  switch (backendState) {
    case 'exchanging_heads':
    case 'streaming_ops':
    case 'applying_ops':
    case 'merging': {
      return 'syncing'
    }
    case 'complete': {
      return 'idle'
    }
    case 'failed':
    case 'reset_required': {
      return 'error'
    }
    default: {
      return 'idle'
    }
  }
}

/**
 * Listens to Tauri sync events and updates the sync store.
 * No-op in browser mode (when Tauri APIs are unavailable).
 * Call once at app root (App.tsx).
 *
 * Lifecycle (`listen()` → `unlisten()` + unmount race) lives
 * in `useTauriEventListener`; this hook owns the per-event handler
 * bodies and the Tauri-only gate (`enabled`).
 */
export function useSyncEvents(): void {
  // Only listen in Tauri context — browser dev sessions skip
  // registration entirely.
  const enabled = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

  // Phase 2 — `sync:progress` listener removed. The
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
        // #1071 — TARGETED invalidation via the shared `reloadChangedPageStores`
        // helper: when `changed_page_ids` is present and non-empty, reload +
        // re-anchor ONLY the mounted page stores in the set; otherwise fall
        // back to reloading every mounted store. The same helper backs the
        // #2505 `blocks:changed` (MCP-write) listener, so both out-of-band
        // write sources share one reconciliation path.
        if (ops_received > 0) {
          reloadChangedPageStores(changed_page_ids)
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

  // #2505 — `blocks:changed` is the out-of-band local-write signal. An MCP
  // read-write tool (append_block / update_block_content / set_property /
  // add_tag / create_page / delete_block) commits and emits this event; unlike
  // a page store's own optimistic write, no mounted store learns about it
  // otherwise (the write is local, so `sync:complete` never fires). Route it
  // through the SAME targeted-reload path the `sync:complete` handler uses so
  // the affected page updates without navigation — no toast, no ops counter,
  // just the reconciliation.
  useTauriEventListener<BlocksChangedPayload>(
    'blocks:changed',
    (event) => {
      try {
        reloadChangedPageStores(event.payload.changed_page_ids)
      } catch (err: unknown) {
        logger.error('useSyncEvents', 'blocks:changed handler failed', undefined, err)
      }
    },
    {
      enabled,
      onError: (err) => {
        logger.warn('useSyncEvents', 'Failed to listen to blocks:changed', undefined, err)
      },
    },
  )
}
