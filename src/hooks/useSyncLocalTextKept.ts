/**
 * useSyncLocalTextKept — says when a synced purge left text in the Trash (#6561).
 *
 * Another device purged a page, or moved it to another space, while this one,
 * out of contact, added blocks under it. The backend keeps those blocks in the
 * Trash under a page of the same title and reports the titles once per import.
 * One toast names every kept page, and a report that lands while it is up adds
 * its titles to it (#6870). The toast stays until dismissed: sync runs unattended.
 *
 * No-op outside Tauri. Call once at app root (App.tsx).
 */

import { useRef } from 'react'

import { useTauriEventListener } from '@/hooks/useTauriEventListener'
import { EVENT_SYNC_LOCAL_TEXT_KEPT, type SyncEvent_Serialize } from '@/lib/bindings'
import { i18n } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

type LocalTextKept = Extract<SyncEvent_Serialize, { type: 'local_text_kept' }>

const LOCAL_TEXT_KEPT_TOAST_ID = 'sync-local-text-kept'

export function useSyncLocalTextKept(): void {
  const enabled = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  // The titles the toast names; empty while it is not up.
  const shownTitles = useRef<string[]>([])

  useTauriEventListener<LocalTextKept>(
    EVENT_SYNC_LOCAL_TEXT_KEPT,
    (event) => {
      const titles = [...shownTitles.current, ...event.payload.page_titles]
      shownTitles.current = titles
      notify.warning(
        i18n.t('sync.localTextKept', {
          count: titles.length,
          titles: titles.map((title) => `“${title}”`).join(', '),
        }),
        {
          id: LOCAL_TEXT_KEPT_TOAST_ID,
          duration: Number.POSITIVE_INFINITY,
          onDismiss: () => {
            shownTitles.current = []
          },
        },
      )
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
