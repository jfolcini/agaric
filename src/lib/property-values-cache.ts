/**
 * property-values-cache — non-React module-level cache for
 * `listPropertyValues(key)` results, keyed on the property `key`.
 *
 * #1425: powers the property-VALUE autocomplete (the value side of a
 * `prop:key=value` editor). Modelled directly on `property-keys-cache.ts`
 * — a Map of cached arrays, an in-flight-dedup Map, a subscriber set, and
 * a lazy materializer-event listener that invalidates on
 * `block:properties-changed`. The only difference is the cache dimension:
 * the *property key* rather than the *space id* (values are inherently
 * key-scoped, and the backend command is not space-scoped).
 *
 * Two worlds consume it: the React autocomplete hook
 * (`useAutocompleteSources` via `useSyncExternalStore`) and any future
 * plain-TS caller. Both share the same Map / in-flight / subscriber set so
 * a propValue anchor re-activation reuses the cached array instead of
 * re-firing the IPC.
 */

import { listen } from '@tauri-apps/api/event'

import { logger } from './logger'
import { listPropertyValues } from './tauri'

/** Tauri event name — mirrors `EVENT_PROPERTY_CHANGED` in
 *  `src-tauri/src/sync_events.rs`. */
export const EVENT_PROPERTY_CHANGED = 'block:properties-changed'

/** Stable empty-array reference returned before the first fetch resolves.
 *  `useSyncExternalStore` requires referentially-stable snapshots when
 *  nothing changed; reusing this constant satisfies that invariant. */
export const PROPERTY_VALUES_EMPTY: string[] = Object.freeze([]) as unknown as string[]

const cache = new Map<string, string[]>()
const inFlight = new Map<string, Promise<string[]>>()
const subscribers = new Set<() => void>()
let listenerInitialized = false

function notify(): void {
  for (const cb of subscribers) cb()
}

/**
 * Drop every cached `key` entry. Pending in-flight fetches are also
 * cleared so a subsequent consumer triggers a fresh IPC instead of
 * awaiting the now-stale promise. Exposed for the Tauri listener and for
 * test setup.
 */
export function invalidatePropertyValuesCache(): void {
  cache.clear()
  inFlight.clear()
  notify()
}

/**
 * Read the cached entry for `key` synchronously. Returns the stable
 * `PROPERTY_VALUES_EMPTY` array when no cached entry exists yet. This is
 * the snapshot fn used by `useSyncExternalStore`.
 */
export function getCachedPropertyValues(key: string): string[] {
  return cache.get(key) ?? PROPERTY_VALUES_EMPTY
}

/**
 * Trigger (or join) a single in-flight `listPropertyValues(key)` fetch.
 * Returns a promise that resolves to the cached array. A second
 * concurrent call before the first resolves shares the same promise, so
 * two callers fire ONE IPC. After resolution the entry is cached until
 * `invalidatePropertyValuesCache()` clears it (manually or via the
 * materializer event).
 *
 * Errors are swallowed to an empty array — matches the property-keys
 * fallback so the popover renders rather than hanging in a loading state
 * forever. The error is logged once per fetch.
 */
export function fetchPropertyValuesOnce(key: string): Promise<string[]> {
  const cached = cache.get(key)
  if (cached) return Promise.resolve(cached)
  const pending = inFlight.get(key)
  if (pending) return pending

  const promise = listPropertyValues(key)
    .then((values) => {
      cache.set(key, values)
      return values
    })
    .catch((err) => {
      logger.warn('property-values-cache', 'failed to load property values', { key }, err)
      const empty: string[] = []
      cache.set(key, empty)
      return empty
    })
    .finally(() => {
      inFlight.delete(key)
      notify()
    })
  inFlight.set(key, promise)
  return promise
}

/**
 * Subscribe to cache mutations (resolution of an in-flight fetch or
 * invalidation). Returns an unsubscribe fn. Used by the React adapter via
 * `useSyncExternalStore`.
 */
export function subscribeToPropertyValuesCache(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/**
 * Lazily register the materializer-event listener. Process-lifetime —
 * once registered it stays for the rest of the session. Mirrors the
 * Tauri-only gate from `property-keys-cache` so jsdom / browser-mode dev
 * sessions don't trigger a `transformCallback` NPE from the unmocked
 * `@tauri-apps/api/event` import.
 */
export function ensurePropertyValuesInvalidationListener(): void {
  if (listenerInitialized) return
  listenerInitialized = true
  const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  if (!inTauri) return
  listen(EVENT_PROPERTY_CHANGED, () => {
    invalidatePropertyValuesCache()
  }).catch((err) => {
    logger.warn(
      'property-values-cache',
      'failed to register property-change listener',
      undefined,
      err,
    )
  })
}

/**
 * Test-only reset. Clears every cached entry, drops in-flight fetches, and
 * resets the lazy-listener flag so each test starts from a clean slate.
 * Imported directly by tests; not part of the public surface.
 */
export function _resetPropertyValuesCacheForTest(): void {
  cache.clear()
  inFlight.clear()
  listenerInitialized = false
  notify()
}
