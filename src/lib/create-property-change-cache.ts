/**
 * create-property-change-cache — generic factory for a non-React,
 * module-level cache of string-array IPC results keyed on a string, with
 * in-flight de-duplication, a subscriber set, and a lazy materializer-event
 * listener that invalidates the whole cache on `block:properties-changed`.
 *
 * #2047: `property-keys-cache.ts` and `property-values-cache.ts` were
 * near-verbatim duplicates of this exact pattern, differing only in the
 * backing IPC, the log tag, and (for keys) a default-key wrapper. This factory
 * is the single implementation; both modules are now thin instantiations that
 * re-export the same public API names they always did.
 *
 * Crucially this preserves the module-level generation-counter guard added in
 * #2025: every invalidate/reset bumps `generation`, and an in-flight fetch that
 * started before the bump refuses to write its (now stale) snapshot back into
 * the cache after the clear. Each instance owns its own `generation` so the two
 * caches stay independent.
 */

import { listen } from '@tauri-apps/api/event'

import { EVENT_PROPERTY_CHANGED } from './block-event-names'
import { logger } from './logger'

/** Options for {@link createPropertyChangeCache}. */
export interface PropertyChangeCacheOptions {
  /** Backing IPC fetch for a given cache key. */
  fetch: (key: string) => Promise<string[]>
  /** Tauri event whose arrival invalidates the whole cache. */
  eventName: string
  /** Module tag used as the first `logger.warn` argument. */
  logTag: string
}

/** Public surface returned by {@link createPropertyChangeCache}. */
export interface PropertyChangeCache {
  /** Stable empty-array reference returned before the first fetch resolves. */
  readonly empty: string[]
  /** Drop every cached entry and pending in-flight fetch; bump generation. */
  invalidate: () => void
  /** Read the cached entry for `key` synchronously (or the stable empty array). */
  getCached: (key: string) => string[]
  /** Trigger (or join) a single in-flight fetch for `key`. */
  fetchOnce: (key: string) => Promise<string[]>
  /** Subscribe to cache mutations; returns an unsubscribe fn. */
  subscribe: (cb: () => void) => () => void
  /** Lazily register the process-lifetime materializer-event listener. */
  ensureListener: () => void
  /** Test-only reset: clears state and the lazy-listener flag. */
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
  const { fetch, eventName, logTag } = options

  const empty: string[] = Object.freeze([]) as unknown as string[]
  const cache = new Map<string, string[]>()
  const inFlight = new Map<string, Promise<string[]>>()
  const subscribers = new Set<() => void>()
  let listenerInitialized = false

  /**
   * Monotonic generation counter. Bumped by every invalidate/reset so an
   * in-flight fetch that started before the bump can detect that its snapshot
   * is stale and refuse to write it back. Without this fence a fetch launched
   * before an invalidation would `cache.set` its pre-change result *after* the
   * clear, resurrecting a deleted entry (or omitting a freshly-added one) until
   * the next invalidation.
   */
  let generation = 0

  function notify(): void {
    for (const cb of subscribers) cb()
  }

  /**
   * Drop every cached entry. Pending in-flight fetches are also cleared so a
   * subsequent consumer triggers a fresh IPC instead of awaiting the now-stale
   * promise. Exposed for the Tauri listener and for test setup.
   *
   * Bumping `generation` fences any in-flight fetch captured before this call
   * so it can't repopulate the cache with its pre-change snapshot.
   */
  function invalidate(): void {
    generation++
    cache.clear()
    inFlight.clear()
    notify()
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
   * resolution the entry is cached until `invalidate()` clears it (manually or
   * via the materializer event).
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

    const startGeneration = generation
    const promise = fetch(key)
      .then((result) => {
        // Only write back if no invalidation/reset raced this fetch.
        // A stale snapshot from before an invalidation must not
        // repopulate the cache (see #2025). The `.finally` below fires
        // the subscriber notification.
        if (generation === startGeneration) {
          cache.set(key, result)
        }
        return result
      })
      .catch((err) => {
        logger.warn(logTag, 'failed to load property data', { key }, err)
        const fallback: string[] = []
        if (generation === startGeneration) {
          cache.set(key, fallback)
        }
        return fallback
      })
      .finally(() => {
        // Only retire our own in-flight entry. A racing invalidation
        // already cleared the map (and may have registered a newer
        // fetch under the same key); deleting here would drop that
        // newer fetch. The matching write-back above already notified.
        if (generation === startGeneration) {
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
   * Lazily register the materializer-event listener. Process-lifetime — once
   * registered it stays for the rest of the session. Mirrors the Tauri-only
   * gate from `useSyncEvents` so jsdom / browser-mode dev sessions don't
   * trigger a `transformCallback` NPE from the unmocked
   * `@tauri-apps/api/event` import.
   */
  function ensureListener(): void {
    if (listenerInitialized) return
    listenerInitialized = true
    const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
    if (!inTauri) return
    listen(eventName, () => {
      invalidate()
    }).catch((err) => {
      logger.warn(logTag, 'failed to register property-change listener', undefined, err)
    })
  }

  /**
   * Test-only reset. Clears every cached entry, drops in-flight fetches, and
   * resets the lazy-listener flag so each test starts from a clean slate.
   */
  function resetForTest(): void {
    generation++
    cache.clear()
    inFlight.clear()
    listenerInitialized = false
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
