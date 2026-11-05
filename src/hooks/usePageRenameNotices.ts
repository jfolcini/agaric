/**
 * usePageRenameNotices — tell the user which of their pages this device
 * renamed after a sync (#6278).
 *
 * Two devices that each make a page with one name (`Foo`, `foo`) keep both
 * once they sync. The device that made the newer page renames it `Foo (2)`
 * and emits `pages:renamed` with what it renamed; this shows it in one toast
 * that stays until dismissed, since the user did not make the change.
 *
 * Nothing to backfill: the backend emits the event after a sync session,
 * while this listener is mounted. The same pass at boot runs before any
 * listener exists, and History lists what it renamed.
 *
 * No-op outside Tauri (browser dev sessions without `__TAURI_INTERNALS__`).
 * Mount once in `App.tsx`.
 */

import { useTauriEventListener } from '@/hooks/useTauriEventListener'
import { i18n } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

/** Must mirror `EVENT_PAGES_RENAMED` in `src-tauri/src/repair/name_collisions.rs`. */
export const PAGES_RENAMED_EVENT = 'pages:renamed'

/** One toast for the notice: a later rename replaces it rather than stacking. */
export const PAGES_RENAMED_TOAST_ID = 'pages-renamed'

/**
 * One entry of the `pages:renamed` payload (Rust `PageRenamed`). Serialize-only
 * on the Rust side (it rides the event, not specta), so this shape is written
 * by hand.
 */
export interface PageRenamed {
  page_id: string
  from: string
  to: string
}

/** Show the notice for `renamed`; nothing for an empty list. */
export function showPagesRenamedToast(renamed: PageRenamed[]): void {
  const [first] = renamed
  if (first === undefined) return
  const message = i18n.t('pages.nameTieRenamed', {
    count: renamed.length,
    from: first.from,
    to: first.to,
  })
  notify.info(message, { id: PAGES_RENAMED_TOAST_ID, duration: Number.POSITIVE_INFINITY })
}

export function usePageRenameNotices(): void {
  const enabled = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  useTauriEventListener<PageRenamed[]>(
    PAGES_RENAMED_EVENT,
    (event) => {
      showPagesRenamedToast(event.payload)
    },
    {
      enabled,
      onError: (err) => {
        logger.warn(
          'usePageRenameNotices',
          `Failed to listen to ${PAGES_RENAMED_EVENT}`,
          undefined,
          err,
        )
      },
    },
  )
}
