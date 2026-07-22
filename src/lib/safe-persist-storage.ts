/**
 * Shared, guarded `localStorage` backing for persisted Zustand stores that
 * additionally surfaces a user-facing warning when a write is lost.
 *
 * The raw guard (never let a `setItem` failure throw out of a store action)
 * lives in the notify-free leaf `guarded-storage.ts`; this module layers the
 * user-facing side effect on top: on a write failure it fires a ONE-SHOT,
 * DEDUPED `notify.warning` (a fixed toast `id` so a burst of repeated quota
 * failures — e.g. every store in a multi-store action chain hitting the same
 * full quota — collapses into a single visible toast instead of spamming).
 *
 * The read path (`migrate`/`merge`) is already hardened per-store against
 * corrupt/missing blobs; creation-time `SecurityError` (storage disabled) is
 * already absorbed by the persist middleware itself. This helper closes the
 * remaining gap: the write path.
 *
 * Usage: pass `storage: safePersistStorage` in a store's
 * `persist(..., { storage: safePersistStorage, ... })` options. Stores that
 * sit in the `notify → error-display` import chain (e.g. `useDebugStore`)
 * must use `guardedPersistStorage` from `guarded-storage.ts` instead to avoid
 * an import cycle — they stay guarded but skip the toast.
 */

import { createGuardedStorage } from '@/lib/guarded-storage'
import { i18n } from '@/lib/i18n'
import { notify } from '@/lib/notify'

/**
 * Fixed dedupe id for the write-failure toast — sonner collapses repeated
 * `notify.warning(..., { id: PERSIST_WRITE_FAILED_TOAST_ID })` calls into a
 * single toast, so a burst of `setItem` failures (e.g. every action in a
 * chain hitting the same full quota) surfaces to the user exactly once.
 */
export const PERSIST_WRITE_FAILED_TOAST_ID = 'persist-write-failed'

/**
 * Guarded persist storage that also warns the user (once, deduped) when a
 * write is lost — pass as `storage: safePersistStorage` in a store's
 * `persist(...)` options.
 */
export const safePersistStorage = createGuardedStorage(() => {
  notify.warning(i18n.t('error.settingsSaveFailed'), { id: PERSIST_WRITE_FAILED_TOAST_ID })
})
