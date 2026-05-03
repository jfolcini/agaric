/**
 * usePropertyKeysCache — shared module-level cache for `listPropertyKeys()`
 * results, keyed on the active `spaceId` (MAINT-189).
 *
 * Three components consume the property-key list to populate filter
 * pickers (`PropertyValuePicker`, `BacklinkFilterBuilder` inside
 * `LinkedReferences` / `UnlinkedReferences`). Before this hook each
 * component fired its own `useEffect([])` IPC on mount, so a view with
 * a backlink panel + several filter rows hit the IPC N times for
 * identical data. This hook collapses every consumer of the same
 * `spaceId` to a single in-flight fetch and shares the cached result
 * across mounts.
 *
 * Invalidation follows the existing `block:properties-changed`
 * convention emitted by the materializer (see
 * `src/hooks/useBlockPropertyEvents.ts` and
 * `src-tauri/src/sync_events.rs::EVENT_PROPERTY_CHANGED`). When the
 * backend signals that property data changed, every cached
 * `spaceId` entry is dropped so the next consumer triggers a fresh
 * fetch. The Tauri listener registers itself lazily on the first hook
 * mount and lives for the rest of the process — there is no per-mount
 * teardown, which is the whole point of the cache.
 *
 * The cache is keyed on `spaceId` even though the underlying IPC is
 * not yet space-scoped, so future per-space migration is a one-line
 * backend change that doesn't need to ripple through the consumers.
 */

import { listen } from '@tauri-apps/api/event'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { logger } from '../lib/logger'
import { listPropertyKeys } from '../lib/tauri'

/** Tauri event name — mirrors `EVENT_PROPERTY_CHANGED` in
 *  `src-tauri/src/sync_events.rs`. */
const EVENT_PROPERTY_CHANGED = 'block:properties-changed'

/** Sentinel cache key for the no-active-space slot (boot, tests). */
const GLOBAL_KEY = '__global__'

/** Stable empty-array reference returned before the first fetch
 *  resolves. `useSyncExternalStore` requires referentially-stable
 *  snapshots when nothing changed; reusing this constant is the
 *  cheapest way to satisfy that invariant. */
const EMPTY: string[] = Object.freeze([]) as unknown as string[]

const cache = new Map<string, string[]>()
const inFlight = new Map<string, Promise<void>>()
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

function fetchOnce(spaceKey: string): void {
  if (cache.has(spaceKey) || inFlight.has(spaceKey)) return
  const promise = listPropertyKeys()
    .then((keys) => {
      cache.set(spaceKey, keys)
    })
    .catch((err) => {
      // Match the per-component fallback before MAINT-189: on failure
      // surface an empty list so the picker still renders rather than
      // hanging in a "loading" state forever. The previous
      // `LinkedReferences`-only toast is replaced by this single
      // shared `logger.warn` — uniform with the other two consumers
      // (`PropertyValuePicker`, `UnlinkedReferences`) which already
      // logged-without-toast.
      logger.warn('usePropertyKeysCache', 'failed to load property keys', { spaceKey }, err)
      cache.set(spaceKey, [])
    })
    .finally(() => {
      inFlight.delete(spaceKey)
      notify()
    })
  inFlight.set(spaceKey, promise)
}

/**
 * Lazily register the materializer-event listener on the first hook
 * mount. The listener is process-lifetime — once registered it stays
 * for the rest of the session, which is the whole point of a shared
 * cache. Mirrors the Tauri-only gate from `useSyncEvents` so jsdom /
 * browser-mode dev sessions don't trigger a `transformCallback`
 * NPE from the unmocked `@tauri-apps/api/event` import. Component
 * tests that mock the event module set `__TAURI_INTERNALS__` (or are
 * fine with the listener being skipped, since invalidation in those
 * tests isn't exercised).
 */
function ensureInvalidationListener(): void {
  if (listenerInitialized) return
  listenerInitialized = true
  const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  if (!inTauri) return
  listen(EVENT_PROPERTY_CHANGED, () => {
    invalidatePropertyKeysCache()
  }).catch((err) => {
    logger.warn(
      'usePropertyKeysCache',
      'failed to register property-change listener',
      undefined,
      err,
    )
  })
}

/** Stable subscribe function for `useSyncExternalStore`. Defined at
 *  module scope so React does not re-subscribe on every render. */
function subscribe(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/**
 * Returns the cached list of property keys for the given space,
 * starting an IPC fetch on first use per `spaceId`. Subsequent mounts
 * with the same `spaceId` reuse the cached array; different
 * `spaceId`s fetch independently. Returns the stable `EMPTY` array
 * before the first fetch resolves.
 */
export function usePropertyKeysCache(spaceId: string | null): string[] {
  const spaceKey = spaceId ?? GLOBAL_KEY

  useEffect(() => {
    ensureInvalidationListener()
    fetchOnce(spaceKey)
  }, [spaceKey])

  const getSnapshot = useCallback(() => cache.get(spaceKey) ?? EMPTY, [spaceKey])

  return useSyncExternalStore(subscribe, getSnapshot)
}

/**
 * Test-only hook reset. Clears every cached entry, drops in-flight
 * fetches, and resets the lazy listener flag so each test starts from
 * a clean slate. Not exported from a public barrel; tests import it
 * directly from this file.
 */
export function _resetPropertyKeysCacheForTest(): void {
  cache.clear()
  inFlight.clear()
  listenerInitialized = false
  notify()
}
