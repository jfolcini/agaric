/**
 * useSyncLocalTextKept — says when a synced purge left text in the Trash (#6561).
 *
 * Another device deleted a page and emptied its Trash while this one, out of
 * contact, wrote blocks under it. The backend keeps those blocks in the Trash
 * under a page of the same title and reports the titles once per import. The
 * toast stays until dismissed: sync runs unattended.
 *
 * No-op outside Tauri. Call once at app root (App.tsx).
 */

import { useTauriEventListener } from '@/hooks/useTauriEventListener'
import { EVENT_SYNC_LOCAL_TEXT_KEPT, type SyncEvent_Serialize } from '@/lib/bindings'
import { i18n } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

type LocalTextKept = Extract<SyncEvent_Serialize, { type: 'local_text_kept' }>

export function useSyncLocalTextKept(): void {
  const enabled = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

  useTauriEventListener<LocalTextKept>(
    EVENT_SYNC_LOCAL_TEXT_KEPT,
    (event) => {
      for (const title of event.payload.page_titles) {
        notify.warning(i18n.t('sync.localTextKept', { title }), {
          duration: Number.POSITIVE_INFINITY,
        })
      }
    },
    {
      enabled,
      onError: (err) => {
        logger.warn(
          'useSyncLocalTextKept',
          'Failed to listen to sync:local_text_kept',
          undefined,
          err,
        )
      },
    },
  )
}
