/**
 * property-keys-cache — non-React module-level cache for
 * `listPropertyKeys()` results, keyed on the active `spaceId`.
 *
 * Originally lived inside `src/hooks/usePropertyKeysCache.ts` but the
 * cache state (Map, in-flight promises, subscriber set, lazy listener
 * init) is plain JavaScript — only the React `useSyncExternalStore`
 * binding required hook scope. Meanwhile a non-React
 * caller (`searchPropertyKeys` in `src/lib/slash-commands.ts`)
 * fired a fresh `list_property_keys` IPC on every keystroke, so the
 * primitives (`fetchPropertyKeysOnce`, `getCachedPropertyKeys`,
 * `subscribeToPropertyKeysCache`, `invalidatePropertyKeysCache`,
 * `ensurePropertyKeysInvalidationListener`) were moved here. The hook
 * becomes a thin React adapter over the same module-level state, so
 * every consumer (slash menu, picker, backlink filter builder) shares
 * one cache and one in-flight fetch per `spaceId`.
 *
 * #2047: the cache mechanics (Map / in-flight dedup / subscribers /
 * generation-counter race guard / lazy listener) are now provided by the
 * shared `createPropertyChangeCache` factory; this module is a thin
 * instantiation that adds the default-`spaceId` wrapper and keeps the
 * historical public export names.
 *
 * Invalidation follows the existing `block:properties-changed`
 * convention emitted by the materializer (see
 * `src/hooks/useBlockPropertyEvents.ts` and
 * `src-tauri/src/sync_events.rs::EVENT_PROPERTY_CHANGED`).
 */

import { EVENT_PROPERTY_CHANGED } from './block-event-names'
import { createPropertyChangeCache } from './create-property-change-cache'
import { listPropertyKeys } from './tauri'

export { EVENT_PROPERTY_CHANGED }

/** Sentinel cache key for the no-active-space slot (boot, tests, the
 *  slash-command picker which does not yet plumb a spaceId). */
export const PROPERTY_KEYS_GLOBAL_KEY = '__global__'

const instance = createPropertyChangeCache({
  fetch: () => listPropertyKeys(),
  logTag: 'property-keys-cache',
  // Skip-when-no-new-key (#2507): the cache holds the DISTINCT-key list, keyed
  // on `spaceId`. A property write only changes that list when it introduces a
  // key not already present, so when every `changed_keys` entry is already a
  // known key we can skip the refetch entirely; a genuinely new key still
  // triggers a blanket invalidate. A payload-less event falls back to a blanket
  // clear. (Trade-off: deleting a key from its last remaining block leaves a
  // momentarily-stale entry — a benign autocomplete staleness that self-heals on
  // the next new-key event or manual `invalidatePropertyKeysCache()`.)
  onPropertyChange: (payload, api) => {
    if (!payload) {
      api.invalidateAll()
      return
    }
    const known = api.cachedValues()
    const introducesNewKey = payload.changed_keys.some((key) => !known.has(key))
    if (introducesNewKey) {
      api.invalidateAll()
    }
  },
})

/** Stable empty-array reference returned before the first fetch
 *  resolves. `useSyncExternalStore` requires referentially-stable
 *  snapshots when nothing changed; reusing this constant is the
 *  cheapest way to satisfy that invariant. */
export const PROPERTY_KEYS_EMPTY: string[] = instance.empty

/**
 * Drop every cached `spaceId` entry. Pending in-flight fetches are
 * also cleared so a subsequent consumer triggers a fresh IPC instead
 * of awaiting the now-stale promise. Exposed for the Tauri listener
 * and for test setup.
 */
export function invalidatePropertyKeysCache(): void {
  instance.invalidate()
}

/**
 * Read the cached entry for `spaceKey` synchronously. Returns the
 * stable `PROPERTY_KEYS_EMPTY` array when no cached entry exists yet.
 * This is the snapshot fn used by `useSyncExternalStore`.
 */
export function getCachedPropertyKeys(spaceKey: string = PROPERTY_KEYS_GLOBAL_KEY): string[] {
  return instance.getCached(spaceKey)
}

/**
 * Trigger (or join) a single in-flight `listPropertyKeys()` fetch for
 * `spaceKey`. Returns a promise that resolves to the cached array. A
 * second concurrent call before the first resolves shares the same
 * promise, so two callers fire ONE IPC. After resolution the entry is
 * cached until `invalidatePropertyKeysCache()` clears it (manually or
 * via the materializer event).
 */
export function fetchPropertyKeysOnce(
  spaceKey: string = PROPERTY_KEYS_GLOBAL_KEY,
): Promise<string[]> {
  return instance.fetchOnce(spaceKey)
}

/**
 * Subscribe to cache mutations (resolution of an in-flight fetch or
 * invalidation). Returns an unsubscribe fn. Used by the React adapter
 * via `useSyncExternalStore`.
 */
export function subscribeToPropertyKeysCache(cb: () => void): () => void {
  return instance.subscribe(cb)
}

/**
 * Lazily register the materializer-event listener. Process-lifetime —
 * once registered it stays for the rest of the session.
 */
export function ensurePropertyKeysInvalidationListener(): void {
  instance.ensureListener()
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
  instance.resetForTest()
}
