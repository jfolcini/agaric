/**
 * useSyncExportRefused — keeps the sync store's refused spaces current (#6523).
 *
 * The backend refuses to send a space's changes while its engine and SQL
 * disagree about a deleted block, and reports the refused spaces on every
 * round that refuses one, then an empty list once they all export again. Each
 * report replaces the last.
 *
 * No-op outside Tauri. Call once at app root (App.tsx).
 */

import { useTauriEventListener } from '@/hooks/useTauriEventListener'
import { logger } from '@/lib/logger'
import { useSyncStore } from '@/stores/sync'

/** Mirrors `EVENT_SYNC_EXPORT_REFUSED` in `agaric-sync/src/sync_events.rs`. */
export const SYNC_EXPORT_REFUSED_EVENT = 'sync:export_refused'

/** `SyncEvent::ExportRefused`, which rides a Tauri event, not specta. */
interface ExportRefusedPayload {
  space_ids: string[]
}

export function useSyncExportRefused(): void {
  const enabled = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

  useTauriEventListener<ExportRefusedPayload>(
    SYNC_EXPORT_REFUSED_EVENT,
    (event) => {
      useSyncStore.getState().setExportRefusedSpaces(event.payload.space_ids)
    },
    {
      enabled,
      onError: (err) => {
        logger.warn(
          'useSyncExportRefused',
          'Failed to listen to sync:export_refused',
          undefined,
          err,
        )
      },
    },
  )
}
