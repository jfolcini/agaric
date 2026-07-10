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
 * #2047: the cache mechanics (Map / in-flight dedup / subscribers /
 * generation-counter race guard / lazy listener) are now provided by the
 * shared `createPropertyChangeCache` factory; this module is a thin
 * instantiation that keeps the historical public export names.
 *
 * Two worlds consume it: the React autocomplete hook
 * (`useAutocompleteSources` via `useSyncExternalStore`) and any future
 * plain-TS caller. Both share the same Map / in-flight / subscriber set so
 * a propValue anchor re-activation reuses the cached array instead of
 * re-firing the IPC.
 */

import { EVENT_PROPERTY_CHANGED } from './block-event-names'
import { createPropertyChangeCache } from './create-property-change-cache'
import { listPropertyValues } from './tauri'

export { EVENT_PROPERTY_CHANGED }

const instance = createPropertyChangeCache({
  fetch: (key) => listPropertyValues(key),
  logTag: 'property-values-cache',
  // Keyed eviction (#2507): the cache is keyed on the property *key*, and a
  // property write's `changed_keys` are exactly those cache keys — so a change
  // to `project` can only stale the `project` value list, never `effort`'s.
  // Evict just the changed keys instead of clearing the whole cache. Fall back
  // to a blanket clear only for a payload-less event (defensive; the current
  // backend always ships `changed_keys`).
  onPropertyChange: (payload, api) => {
    if (!payload) {
      api.invalidateAll()
      return
    }
    api.invalidateKeys(payload.changed_keys)
  },
})

/** Stable empty-array reference returned before the first fetch resolves.
 *  `useSyncExternalStore` requires referentially-stable snapshots when
 *  nothing changed; reusing this constant satisfies that invariant. */
export const PROPERTY_VALUES_EMPTY: string[] = instance.empty

/**
 * Drop every cached `key` entry. Pending in-flight fetches are also
 * cleared so a subsequent consumer triggers a fresh IPC instead of
 * awaiting the now-stale promise. Exposed for the Tauri listener and for
 * test setup.
 */
export function invalidatePropertyValuesCache(): void {
  instance.invalidate()
}

/**
 * Read the cached entry for `key` synchronously. Returns the stable
 * `PROPERTY_VALUES_EMPTY` array when no cached entry exists yet. This is
 * the snapshot fn used by `useSyncExternalStore`.
 */
export function getCachedPropertyValues(key: string): string[] {
  return instance.getCached(key)
}

/**
 * Trigger (or join) a single in-flight `listPropertyValues(key)` fetch.
 * Returns a promise that resolves to the cached array. A second
 * concurrent call before the first resolves shares the same promise, so
 * two callers fire ONE IPC. After resolution the entry is cached until
 * `invalidatePropertyValuesCache()` clears it (manually or via the
 * materializer event).
 */
export function fetchPropertyValuesOnce(key: string): Promise<string[]> {
  return instance.fetchOnce(key)
}

/**
 * Subscribe to cache mutations (resolution of an in-flight fetch or
 * invalidation). Returns an unsubscribe fn. Used by the React adapter via
 * `useSyncExternalStore`.
 */
export function subscribeToPropertyValuesCache(cb: () => void): () => void {
  return instance.subscribe(cb)
}

/**
 * Lazily register the materializer-event listener. Process-lifetime —
 * once registered it stays for the rest of the session.
 */
export function ensurePropertyValuesInvalidationListener(): void {
  instance.ensureListener()
}

/**
 * Test-only reset. Clears every cached entry, drops in-flight fetches, and
 * resets the lazy-listener flag so each test starts from a clean slate.
 * Imported directly by tests; not part of the public surface.
 */
export function _resetPropertyValuesCacheForTest(): void {
  instance.resetForTest()
}
