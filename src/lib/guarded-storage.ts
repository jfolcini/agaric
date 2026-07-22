/**
 * Leaf builder for guarded `localStorage`-backed Zustand `persist` storage.
 *
 * zustand v5's `persist` middleware calls the storage's `setItem()`
 * synchronously right after every `set()`. The default JSON storage
 * (`createJSONStorage(() => localStorage)`) leaves that call unguarded, so
 * a write-time failure — most commonly `QuotaExceededError` when
 * `localStorage` is full — throws straight out of the triggering store
 * action into whatever called it. Multi-store action chains (e.g.
 * `useTabsStore.navigateToPage`, which also touches recent-pages,
 * navigation, and journal in the same tick) abort mid-way, leaving
 * committed in-memory state with stale data still sitting in
 * `localStorage`.
 *
 * This module is deliberately a **leaf**: it imports only the logger, never
 * `notify`. The user-facing toast lives one layer up in
 * `safe-persist-storage.ts`, which passes an `onWriteError` callback here.
 * Keeping the raw wrapper notify-free lets stores that themselves sit in the
 * `notify → error-display` dependency chain (e.g. `useDebugStore`, which
 * `error-display` reads `getDebugMode` from) use guarded storage via
 * {@link guardedPersistStorage} without closing an import cycle — the
 * frontend-cycles guard bans those outright.
 */

import { createJSONStorage } from 'zustand/middleware'
import type { StateStorage } from 'zustand/middleware'

import { logger } from '@/lib/logger'

const LOG_MODULE = 'lib/guarded-storage'

/**
 * Invoked (best-effort, after logging) when a `setItem` write throws — used
 * by `safe-persist-storage.ts` to surface a deduped user-facing warning.
 * Kept optional so the notify-free {@link guardedPersistStorage} can omit it.
 */
export type PersistWriteErrorHandler = (err: unknown, name: string) => void

function createRawGuardedStorage(onWriteError?: PersistWriteErrorHandler): StateStorage {
  return {
    getItem: (name) => {
      try {
        return localStorage.getItem(name)
      } catch (err) {
        logger.warn(LOG_MODULE, `getItem failed for "${name}"`, undefined, err)
        return null
      }
    },
    setItem: (name, value) => {
      try {
        localStorage.setItem(name, value)
      } catch (err) {
        // Never let a write-time failure (typically QuotaExceededError)
        // escape into the calling store action — see module doc above.
        logger.warn(
          LOG_MODULE,
          `setItem failed for "${name}" — persisted state is now stale`,
          undefined,
          err,
        )
        onWriteError?.(err, name)
      }
    },
    removeItem: (name) => {
      try {
        localStorage.removeItem(name)
      } catch (err) {
        logger.warn(LOG_MODULE, `removeItem failed for "${name}"`, undefined, err)
      }
    },
  }
}

/**
 * Build a guarded persist storage whose raw reads/writes never throw. Built
 * via zustand's own `createJSONStorage` so JSON (de)serialization matches the
 * default behaviour exactly; only the underlying `localStorage` access is
 * guarded. Pass `onWriteError` to react to a write failure (e.g. a toast).
 */
export function createGuardedStorage(onWriteError?: PersistWriteErrorHandler) {
  return createJSONStorage(() => createRawGuardedStorage(onWriteError))
}

/**
 * Guarded persist storage with no user-facing side effect (logs only). For
 * stores that cannot import `notify` without closing an import cycle — see
 * the module doc. Prefer `safePersistStorage` (which also toasts) everywhere
 * else.
 */
export const guardedPersistStorage = createGuardedStorage()
