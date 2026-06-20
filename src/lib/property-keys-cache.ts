/**
 * property-keys-cache — non-React module-level cache for
 * `listPropertyKeys()` results, keyed on the active `spaceId`.
 *
 * Originally lived inside `src/hooks/usePropertyKeysCache.ts` but the
 * cache state (Map, in-flight promises, subscriber set, lazy listener
 * init) is plain JavaScript — only the React `useSyncExternalStore`
 * Binding required hook scope. surfaced a non-React
 * caller (`searchPropertyKeys` in `src/lib/slash-commands.ts`) that
 * fired a fresh `list_property_keys` IPC on every keystroke, so the
 * primitives (`fetchPropertyKeysOnce`, `getCachedPropertyKeys`,
 * `subscribeToPropertyKeysCache`, `invalidatePropertyKeysCache`,
 * `ensurePropertyKeysInvalidationListener`) were moved here. The hook
 * becomes a thin React adapter over the same module-level state, so
 * every consumer (slash menu, picker, backlink filter builder) shares
 * one cache and one in-flight fetch per `spaceId`.
 *
 * Invalidation follows the existing `block:properties-changed`
 * convention emitted by the materializer (see
 * `src/hooks/useBlockPropertyEvents.ts` and
 * `src-tauri/src/sync_events.rs::EVENT_PROPERTY_CHANGED`).
 */

import { listen } from '@tauri-apps/api/event'

import { logger } from './logger'
import { listPropertyKeys } from './tauri'

/** Tauri event name — mirrors `EVENT_PROPERTY_CHANGED` in
 *  `src-tauri/src/sync_events.rs`. */
export const EVENT_PROPERTY_CHANGED = 'block:properties-changed'

/** Sentinel cache key for the no-active-space slot (boot, tests, the
 *  slash-command picker which does not yet plumb a spaceId). */
export const PROPERTY_KEYS_GLOBAL_KEY = '__global__'

/** Stable empty-array reference returned before the first fetch
 *  resolves. `useSyncExternalStore` requires referentially-stable
 *  snapshots when nothing changed; reusing this constant is the
 *  cheapest way to satisfy that invariant. */
export const PROPERTY_KEYS_EMPTY: string[] = Object.freeze([]) as unknown as string[]

const cache = new Map<string, string[]>()
const inFlight = new Map<string, Promise<string[]>>()
const subscribers = new Set<() => void>()
let listenerInitialized = false

function notify(): void {
  for (const cb of subscribers) cb()
}

/**
 * Drop every cached `spaceId` entry. Pending in-flight fetches are
 * also cleared so a subsequent consumer triggers a fresh IPC instead
 * of awaiting the now-stale promise. Exposed for the Tauri listener
 * and for test setup.
 */
export function invalidatePropertyKeysCache(): void {
  cache.clear()
  inFlight.clear()
  notify()
}

/**
 * Read the cached entry for `spaceKey` synchronously. Returns the
 * stable `PROPERTY_KEYS_EMPTY` array when no cached entry exists yet.
 * This is the snapshot fn used by `useSyncExternalStore`.
 */
export function getCachedPropertyKeys(spaceKey: string = PROPERTY_KEYS_GLOBAL_KEY): string[] {
  return cache.get(spaceKey) ?? PROPERTY_KEYS_EMPTY
}

/**
 * Trigger (or join) a single in-flight `listPropertyKeys()` fetch for
 * `spaceKey`. Returns a promise that resolves to the cached array. A
 * second concurrent call before the first resolves shares the same
 * promise, so two callers fire ONE IPC. After resolution the entry is
 * cached until `invalidatePropertyKeysCache()` clears it (manually or
 * via the materializer event).
 *
 * Errors are swallowed to an empty array — matches the pre-cache
 * fallback so pickers still render rather than hanging in a loading
 * state forever. The error is logged once per fetch.
 */
export function fetchPropertyKeysOnce(
  spaceKey: string = PROPERTY_KEYS_GLOBAL_KEY,
): Promise<string[]> {
  const cached = cache.get(spaceKey)
  if (cached) return Promise.resolve(cached)
  const pending = inFlight.get(spaceKey)
  if (pending) return pending

  const promise = listPropertyKeys()
    .then((keys) => {
      cache.set(spaceKey, keys)
      return keys
    })
    .catch((err) => {
      logger.warn('property-keys-cache', 'failed to load property keys', { spaceKey }, err)
      const empty: string[] = []
      cache.set(spaceKey, empty)
      return empty
    })
    .finally(() => {
      inFlight.delete(spaceKey)
      notify()
    })
  inFlight.set(spaceKey, promise)
  return promise
}

/**
 * Subscribe to cache mutations (resolution of an in-flight fetch or
 * invalidation). Returns an unsubscribe fn. Used by the React adapter
 * via `useSyncExternalStore`.
 */
export function subscribeToPropertyKeysCache(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/**
 * Lazily register the materializer-event listener. Process-lifetime —
 * once registered it stays for the rest of the session. Mirrors the
 * Tauri-only gate from `useSyncEvents` so jsdom / browser-mode dev
 * sessions don't trigger a `transformCallback` NPE from the unmocked
 * `@tauri-apps/api/event` import.
 */
export function ensurePropertyKeysInvalidationListener(): void {
  if (listenerInitialized) return
  listenerInitialized = true
  const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  if (!inTauri) return
  listen(EVENT_PROPERTY_CHANGED, () => {
    invalidatePropertyKeysCache()
  }).catch((err) => {
    logger.warn(
      'property-keys-cache',
      'failed to register property-change listener',
      undefined,
      err,
    )
  })
}

/**
 * Convenience helper for non-React callers (slash-command picker,
 * future plain-TS consumers): ensures the invalidation listener is
 * registered, joins/starts a single in-flight fetch, and returns the
 * cached array. Equivalent to a one-shot version of the React hook.
 */
export function getPropertyKeys(spaceKey: string = PROPERTY_KEYS_GLOBAL_KEY): Promise<string[]> {
  ensurePropertyKeysInvalidationListener()
  return fetchPropertyKeysOnce(spaceKey)
}

/**
 * Test-only reset. Clears every cached entry, drops in-flight fetches,
 * and resets the lazy-listener flag so each test starts from a clean
 * slate. Imported directly by tests; not part of the public surface.
 */
export function _resetPropertyKeysCacheForTest(): void {
  cache.clear()
  inFlight.clear()
  listenerInitialized = false
  notify()
}
