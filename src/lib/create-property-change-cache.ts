/**
 * create-property-change-cache — generic factory for a non-React,
 * module-level cache of string-array IPC results keyed on a string, with
 * in-flight de-duplication, a subscriber set, and an invalidation strategy
 * driven by the shared `block:properties-changed` dispatcher.
 *
 * #2047: `property-keys-cache.ts` and `property-values-cache.ts` were
 * near-verbatim duplicates of this exact pattern, differing only in the
 * backing IPC, the log tag, and (for keys) a default-key wrapper. This factory
 * is the single implementation; both modules are now thin instantiations that
 * re-export the same public API names they always did.
 *
 * #2507: this factory used to register its OWN `listen('block:properties-changed')`
 * per instance and blanket-clear the whole cache on every event — two of the
 * three redundant listeners the issue calls out. It now registers a fan-out
 * TARGET on the single module-level dispatcher (`property-change-dispatch.ts`)
 * and each instance supplies an `onPropertyChange` strategy that inspects the
 * event payload (`{ block_id, changed_keys }`) to invalidate only what actually
 * went stale (per-`changed_keys` eviction for the value cache; a
 * skip-when-no-new-key check for the key cache). A blanket clear is still the
 * default when no strategy is supplied.
 *
 * Race guard (#2025): every cache key carries an epoch. A blanket invalidate
 * bumps a global epoch; a keyed eviction bumps that key's epoch. An in-flight
 * fetch captures both epochs at start and refuses to write its (now stale)
 * snapshot back if either advanced — so neither a full clear NOR a targeted
 * eviction can be undone by a fetch that was already in flight when it happened.
 * Each instance owns its own epochs so the two caches stay independent.
 */

import { EVENT_PROPERTY_CHANGED } from './block-event-names'
import { logger } from './logger'
import {
  _resetPropertyChangeDispatchForTest,
  ensurePropertyChangeDispatch,
  type PropertyChangedPayload,
  registerPropertyChangeTarget,
} from './property-change-dispatch'

/**
 * Invalidation toolkit handed to an instance's {@link
 * PropertyChangeCacheOptions.onPropertyChange} strategy on each event.
 */
export interface PropertyChangeInvalidationApi {
  /** Drop every entry + in-flight fetch (blanket clear, bumps the global epoch). */
  invalidateAll: () => void
  /** Evict only the named cache keys (bumps each key's epoch); a no-op for []. */
  invalidateKeys: (keys: string[]) => void
  /** The union of all values currently cached across every entry. */
  cachedValues: () => Set<string>
}

/** Options for {@link createPropertyChangeCache}. */
export interface PropertyChangeCacheOptions {
  /** Backing IPC fetch for a given cache key. */
  fetch: (key: string) => Promise<string[]>
  /** Module tag used as the first `logger.warn` argument. */
  logTag: string
  /**
   * Keyed invalidation strategy invoked once per `block:properties-changed`
   * event with the event payload (or `undefined` for a payload-less event) and
   * an {@link PropertyChangeInvalidationApi}. Defaults to a blanket
   * `invalidateAll()` — the pre-#2507 behavior.
   */
  onPropertyChange?: (
    payload: PropertyChangedPayload | undefined,
    api: PropertyChangeInvalidationApi,
  ) => void
}

/** Public surface returned by {@link createPropertyChangeCache}. */
export interface PropertyChangeCache {
  /** Stable empty-array reference returned before the first fetch resolves. */
  readonly empty: string[]
  /** Drop every cached entry and pending in-flight fetch; bump the global epoch. */
  invalidate: () => void
  /** Read the cached entry for `key` synchronously (or the stable empty array). */
  getCached: (key: string) => string[]
  /** Trigger (or join) a single in-flight fetch for `key`. */
  fetchOnce: (key: string) => Promise<string[]>
  /** Subscribe to cache mutations; returns an unsubscribe fn. */
  subscribe: (cb: () => void) => () => void
  /** Lazily register the process-lifetime property-change fan-out target. */
  ensureListener: () => void
  /** Test-only reset: clears state, the target registration, and the dispatcher. */
  resetForTest: () => void
}

/**
 * Build a property-change cache instance. See the module doc for the shared
 * behavior; `empty` is frozen so `useSyncExternalStore` snapshots stay
 * referentially stable when nothing has been fetched yet.
 */
export function createPropertyChangeCache(
  options: PropertyChangeCacheOptions,
): PropertyChangeCache {
  const { fetch, logTag } = options
  const onPropertyChange = options.onPropertyChange ?? ((_payload, api) => api.invalidateAll())

  const empty: string[] = Object.freeze([]) as unknown as string[]
  const cache = new Map<string, string[]>()
  const inFlight = new Map<string, Promise<string[]>>()
  const subscribers = new Set<() => void>()

  let targetRegistered = false
  let unregisterTarget: (() => void) | null = null

  /**
   * Epoch fences for the in-flight write-back race (#2025). `globalEpoch` is
   * bumped by every blanket invalidate/reset (fences ALL in-flight fetches);
   * `keyEpoch` tracks a per-key counter bumped by keyed eviction (fences only
   * that key's in-flight fetch). A fetch captures both at start and writes back
   * only if neither advanced.
   */
  let globalEpoch = 0
  const keyEpoch = new Map<string, number>()

  function notify(): void {
    for (const cb of subscribers) cb()
  }

  /**
   * Drop every cached entry. Pending in-flight fetches are also cleared so a
   * subsequent consumer triggers a fresh IPC instead of awaiting the now-stale
   * promise. Bumping `globalEpoch` fences any in-flight fetch captured before
   * this call so it can't repopulate the cache with its pre-change snapshot.
   */
  function invalidate(): void {
    globalEpoch++
    cache.clear()
    inFlight.clear()
    keyEpoch.clear()
    notify()
  }

  /**
   * Evict only the named cache keys, bumping each one's epoch so an in-flight
   * fetch for that key can't write its stale snapshot back. Other keys — and
   * their in-flight fetches — are untouched. A no-op for an empty list.
   */
  function invalidateKeys(keys: string[]): void {
    if (keys.length === 0) return
    for (const key of keys) {
      keyEpoch.set(key, (keyEpoch.get(key) ?? 0) + 1)
      cache.delete(key)
      inFlight.delete(key)
    }
    notify()
  }

  /** The union of every value currently cached across all entries. */
  function cachedValues(): Set<string> {
    const values = new Set<string>()
    for (const entry of cache.values()) {
      for (const value of entry) values.add(value)
    }
    return values
  }

  const invalidationApi: PropertyChangeInvalidationApi = {
    invalidateAll: invalidate,
    invalidateKeys,
    cachedValues,
  }

  /**
   * Read the cached entry for `key` synchronously. Returns the stable `empty`
   * array when no cached entry exists yet. This is the snapshot fn used by
   * `useSyncExternalStore`.
   */
  function getCached(key: string): string[] {
    return cache.get(key) ?? empty
  }

  /**
   * Trigger (or join) a single in-flight `fetch(key)`. Returns a promise that
   * resolves to the cached array. A second concurrent call before the first
   * resolves shares the same promise, so two callers fire ONE IPC. After
   * resolution the entry is cached until an invalidation clears it (manually or
   * via the dispatcher).
   *
   * Errors are swallowed to an empty array so pickers/popovers still render
   * rather than hanging in a loading state forever. The error is logged once
   * per fetch.
   */
  function fetchOnce(key: string): Promise<string[]> {
    const cached = cache.get(key)
    if (cached) return Promise.resolve(cached)
    const pending = inFlight.get(key)
    if (pending) return pending

    const startGlobal = globalEpoch
    const startKey = keyEpoch.get(key) ?? 0
    // No blanket clear AND no eviction of this key raced the fetch.
    const fresh = (): boolean =>
      globalEpoch === startGlobal && (keyEpoch.get(key) ?? 0) === startKey

    const promise = fetch(key)
      .then((result) => {
        // Only write back if no invalidation/eviction raced this fetch. A
        // stale snapshot from before an invalidation must not repopulate the
        // cache (see #2025). The `.finally` below fires the notification.
        if (fresh()) {
          cache.set(key, result)
        }
        return result
      })
      .catch((err) => {
        logger.warn(logTag, 'failed to load property data', { key }, err)
        const fallback: string[] = []
        if (fresh()) {
          cache.set(key, fallback)
        }
        return fallback
      })
      .finally(() => {
        // Only retire our own in-flight entry. A racing invalidation already
        // cleared/replaced the map entry; deleting here would drop a newer
        // fetch registered under the same key. The write-back above notified.
        if (fresh()) {
          inFlight.delete(key)
          notify()
        }
      })
    inFlight.set(key, promise)
    return promise
  }

  /**
   * Subscribe to cache mutations (resolution of an in-flight fetch or
   * invalidation). Returns an unsubscribe fn. Used by the React adapter via
   * `useSyncExternalStore`.
   */
  function subscribe(cb: () => void): () => void {
    subscribers.add(cb)
    return () => {
      subscribers.delete(cb)
    }
  }

  /**
   * Lazily register this instance's fan-out target on the shared
   * `block:properties-changed` dispatcher and make sure the dispatcher's single
   * process-lifetime listener is wired up. Idempotent — the target is added
   * once, and `ensurePropertyChangeDispatch` self-guards (and retries on a prior
   * `listen()` failure). Once registered the target stays for the session.
   */
  function ensureListener(): void {
    if (!targetRegistered) {
      targetRegistered = true
      unregisterTarget = registerPropertyChangeTarget((payload) => {
        onPropertyChange(payload, invalidationApi)
      })
    }
    ensurePropertyChangeDispatch((err) => {
      logger.warn(logTag, 'failed to register property-change listener', undefined, err)
    })
  }

  /**
   * Test-only reset. Clears every cached entry, drops in-flight fetches,
   * unregisters the fan-out target, and resets the shared dispatcher so each
   * test starts from a clean slate.
   */
  function resetForTest(): void {
    globalEpoch++
    cache.clear()
    inFlight.clear()
    keyEpoch.clear()
    targetRegistered = false
    if (unregisterTarget) {
      unregisterTarget()
      unregisterTarget = null
    }
    _resetPropertyChangeDispatchForTest()
    notify()
  }

  return {
    empty,
    invalidate,
    getCached,
    fetchOnce,
    subscribe,
    ensureListener,
    resetForTest,
  }
}

// Re-exported so callers building a cache don't need a second import for the
// default `block:properties-changed` event name.
export { EVENT_PROPERTY_CHANGED }
