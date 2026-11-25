/**
 * useSyncLocalTextKept — says when a synced purge left text in the Trash (#6561).
 *
 * Another device purged a page, or moved it to another space, while this one,
 * out of contact, added blocks under it. The backend keeps those blocks in the
 * Trash under a page of the same title and reports the titles once per import.
 * One toast stays until dismissed, since sync runs unattended. It names a single
 * kept page and counts several, adding a report that lands while it is up, and
 * opens the Trash, which lists them first (#6870).
 *
 * No-op outside Tauri. Call once at app root (App.tsx).
 */

import { useRef } from 'react'

import { useTauriEventListener } from '@/hooks/useTauriEventListener'
import { EVENT_SYNC_LOCAL_TEXT_KEPT, type SyncEvent } from '@/lib/bindings'
import { i18n } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { clampText } from '@/lib/text-utils'
import { useNavigationStore } from '@/stores/navigation'

type LocalTextKept = Extract<SyncEvent, { type: 'local_text_kept' }>

const LOCAL_TEXT_KEPT_TOAST_ID = 'sync-local-text-kept'

export function useSyncLocalTextKept(): void {
  const enabled = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  // The kept pages' titles the toast is up for; empty while it is not.
  const shownTitles = useRef<string[]>([])

  useTauriEventListener<LocalTextKept>(
    EVENT_SYNC_LOCAL_TEXT_KEPT,
    (event) => {
      const titles = [...shownTitles.current, ...event.payload.page_titles]
      shownTitles.current = titles
      // sonner's action button closes the toast without calling `onDismiss`.
      const closed = () => {
        shownTitles.current = []
      }
      notify.warning(
        i18n.t('sync.localTextKept', {
          count: titles.length,
          title: clampText(titles[0] ?? '', 40),
        }),
        {
          id: LOCAL_TEXT_KEPT_TOAST_ID,
          duration: Number.POSITIVE_INFINITY,
          action: {
            label: i18n.t('palette.cmdGoTrash'),
            onClick: () => {
              closed()
              useNavigationStore.getState().setView('trash')
            },
          },
          onDismiss: closed,
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
