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

import { useTauriEventListener } from '@/hooks/useTauriEventListener'
import { announce } from '@/lib/announcer'
import { recordGraphStructureChange } from '@/lib/graph-structure-events'
import { i18n } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { invalidateNameCaches } from '@/lib/name-change-bus'
import { notify } from '@/lib/notify'
import { isPairingWindowRejection } from '@/lib/pairing-rejections'
import { forEachLivePageStoreGroup } from '@/stores/page-blocks'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import { useSyncStore } from '@/stores/sync'
import { useUndoStore } from '@/stores/undo'

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
  /**
   * #4305 — how many blocks this sync session actually changed or purged.
   * The ONLY honest "did anything happen" signal on this event, and the only
   * field a "N changes" string may be built from.
   *
   * `ops_received` / `ops_sent` are protocol *message* counts — one per
   * registered space, sent whether or not that space had a delta. On a
   * converged pair with two spaces they are `2` on every 60 s resync tick,
   * forever, which is how "Synced 2 changes from device" came to fire once a
   * minute on an idle, fully-converged pair with no edits on either side.
   *
   * - `0` — the session completed and moved nothing. Stay silent AND skip the
   *   reload: there is nothing to say and nothing to reload.
   * - `> 0` — exactly that many blocks changed. Safe to count.
   * - `null` / absent — content changed but the count is not enumerable (the
   *   whole-space snapshot catch-up, which reimports an entire space). Falls
   *   back to a countless message plus a full reload. Deliberately NOT
   *   silence: a producer that forgets this field must be loud, not mute.
   */
  changed_blocks?: number | null
}

export interface SyncErrorPayload {
  type: 'error'
  message: string
  remote_device_id: string
}

/**
 * #2505 — payload of the `blocks:changed` event (Rust `BlocksChangedEvent`,
 * `src-tauri/agaric-sync/src/sync_events.rs`). Emitted after an out-of-band local write —
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

  // #4550 — reload EVERY live provider store for a changed page, not only
  // the registry slot's. A page can legitimately have two mounted stores (it
  // is open in a tab AND embedded elsewhere, or a #1560 transient remount is
  // in flight); `forEachPageStore` hands out only the most-recently-mounted
  // one, so the other would keep serving the pre-sync snapshot for the rest
  // of the session. Reloading each of them is the belt; the registry's
  // block-state fan-out (`mirrorToSiblings`) is the braces — this path stays
  // correct even if that fan-out is ever bypassed.
  forEachLivePageStoreGroup((pageId, pageStores) => {
    // In targeted mode, skip stores whose page wasn't touched — they cannot
    // have changed, so reloading them is pure waste. In fallback mode
    // (`targeted == null`) reload every store.
    if (targeted && !targeted.has(pageId)) return
    // #731 — re-anchor this page's positional undo state BEFORE the reload.
    // The out-of-band ops just applied shifted the backend op-log indexing
    // that `undoDepth` addresses; without this reset the next Ctrl+Z would
    // reverse the wrong op. Keyed by the same pageId the block reload uses,
    // and fired ONCE per page however many provider stores it has.
    reanchorUndo(pageId)
    for (const pageStore of pageStores) pageStore.getState().load()
  })

  // Resolve-cache preload — a changed page's / tag's title may have moved.
  // Takes the active space id so the re-fetch only re-keys current-space pages.
  //
  // #3321 — forward the SAME `targeted` set used above instead of discarding
  // it. The preload's page half then re-resolves exactly those ids in one
  // `batchResolve` instead of paginating the whole space (30 sequential
  // `list_blocks` round-trips in a 3,000-page vault, every ~3 s while a peer
  // types); its tag half still runs unconditionally because tags carry no
  // changed-id signal. `null` (the fallback branch) keeps the full scan.
  const refreshSpaceId = useSpaceStore.getState().currentSpaceId
  useResolveStore.getState().preload(refreshSpaceId ?? undefined, true, targeted ?? undefined)

  // #1530 — out-of-band ops also change the page-link graph topology; bump the
  // graph-structure signal so a mounted GraphView refetches (stale-while-
  // revalidate) instead of serving stale nodes/edges until the TTL.
  recordGraphStructureChange()

  // #4007 — and they change page/tag NAMES. The picker's `pagesListRef` /
  // `tagsListRef` caches are filled once per space and only learn about
  // mutations that a local surface announces on the name-change bus, so a
  // peer's rename or delete (or an MCP write) would otherwise keep being
  // offered under the old name for the rest of the session. The event set
  // here is unknown-shape — `changed_page_ids` carries owning-page ids, not
  // titles, and says nothing about tags — so drop both caches and let the
  // next picker read re-fetch, exactly as the resolve preload above does for
  // chip titles.
  invalidateNameCaches()
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
        const { ops_received, ops_sent, changed_page_ids, changed_blocks } = event.payload
        const store = useSyncStore.getState()
        // The store writes are unconditional: `ops_*` feed the status panel's
        // honestly-labelled sync-message counters, and `lastSynced` is the
        // liveness signal that makes silence safe. A converged no-op tick still
        // moved the "last synced" clock and still lit the sidebar status dot —
        // the user is not being kept in the dark, they are being kept quiet.
        store.setState('idle')
        store.setOpsReceived(ops_received)
        store.setOpsSent(ops_sent)
        store.updateLastSynced(new Date().toISOString())

        // #4305 — a converged sync that moved nothing says nothing and reloads
        // nothing. `changed_blocks === 0` is the backend stating exactly that;
        // `ops_received > 0` (the old gate) is true on every tick of a
        // perfectly healthy pair, because it counts one message per space.
        //
        // The pre-#4305 gate cost more than a toast: an empty `changed_page_ids`
        // fell through to `reloadChangedPageStores`'s FULL-reload branch, so an
        // idle pair reloaded every mounted page store and re-ran the resolve
        // preload once a minute, forever, for nothing.
        if (changed_blocks === 0) return

        // Something changed. Count it if the backend could count it; say so
        // without a number if it could not (whole-space snapshot catch-up).
        if (typeof changed_blocks === 'number') {
          notify.success(i18n.t('sync.changesApplied', { count: changed_blocks }))
          announce(i18n.t('announce.syncChangesApplied', { count: changed_blocks }))
        } else {
          notify.success(i18n.t('sync.changesAppliedUnknownCount'))
          announce(i18n.t('announce.syncChangesAppliedUnknownCount'))
        }

        // #1071 — TARGETED invalidation via the shared `reloadChangedPageStores`
        // helper: when `changed_page_ids` is present and non-empty, reload +
        // re-anchor ONLY the mounted page stores in the set; otherwise fall
        // back to reloading every mounted store. The same helper backs the
        // #2505 `blocks:changed` (MCP-write) listener, so both out-of-band
        // write sources share one reconciliation path.
        //
        // #4305: reached whenever anything changed — including the snapshot
        // catch-up path, whose `changed_blocks: null` + empty page-id set is
        // precisely the full-reload case. Before #4305 that path emitted
        // `ops_received: 0` and so reloaded nothing at all, despite its own
        // comment promising the frontend would fall back to a full reload.
        reloadChangedPageStores(changed_page_ids)
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
        // The store update is unconditional: it is the signal `PairingDialog`
        // reads to turn a waiting joiner into an immediate "wrong code", and
        // it is also what the status panel reflects. Only the *toast* is
        // conditional below.
        useSyncStore.getState().setState('error', message)
        // #3505 — a pairing-window refusal is the handshake working, not a
        // failed sync, and shouting "Sync failed" about it is worst exactly
        // where it happens: both dialogs arm their marker on open, so both
        // devices dial and refuse each other BEFORE either user has typed a
        // passphrase. Both users then got a red "Sync failed: pairing
        // passphrase proof required" at the precise moment they were being
        // asked to trust the pairing flow. Since #3491 the device that
        // *detects* the mismatch raises the same string locally, so the toast
        // fired on both ends for a single doomed cross-dial.
        //
        // Suppressed here rather than by not emitting the event, because the
        // event is load-bearing — see the store write above. The dialog is the
        // surface the user is looking at during a pairing window, and it owns
        // the story: "wrong code" on the proof rejection, its own countdown
        // otherwise.
        if (isPairingWindowRejection(message)) {
          logger.debug('useSyncEvents', 'suppressed a pairing-window rejection toast', { message })
          return
        }
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
