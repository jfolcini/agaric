/**
 * property-keys-cache — TanStack Query-backed cache for
 * `listPropertyKeys()` results, keyed on the active `spaceId`.
 *
 * #2596 (pilot proof-point 1): the hand-rolled module-level cache
 * (Map / in-flight dedup / subscriber set / epoch race-guard) that used to
 * live in `create-property-change-cache.ts` is gone — TanStack Query's
 * module-level `queryClient` singleton now provides cache-hit reuse and
 * in-flight de-duplication for free. This module keeps the historical
 * public export names so every consumer (slash menu, picker, backlink
 * filter builder, the React hook) shares one query per `spaceId` and one
 * event-driven invalidation path.
 *
 * Invalidation follows the existing `block:properties-changed` convention
 * emitted by the materializer, fanned out through the single module-level
 * dispatcher (`property-change-dispatch.ts`). The key cache uses the
 * skip-when-no-new-key strategy (#2507): the cached value is the DISTINCT-key
 * list, so a write only changes it when it introduces a key not already
 * present — otherwise the refetch is skipped entirely.
 */

import { EVENT_PROPERTY_CHANGED } from '@/lib/block-event-names'
import { logger } from '@/lib/logger'
import {
  _resetPropertyChangeDispatchForTest,
  ensurePropertyChangeDispatch,
  registerPropertyChangeTarget,
} from '@/lib/property-change-dispatch'
import { queryClient } from '@/lib/query-client'
import { listPropertyKeys } from '@/lib/tauri'

export { EVENT_PROPERTY_CHANGED }

/** Sentinel cache key for the no-active-space slot (boot, tests, the
 *  slash-command picker which does not yet plumb a spaceId). */
export const PROPERTY_KEYS_GLOBAL_KEY = '__global__'

/** Query-key root shared by every space-scoped property-keys entry. */
const PROPERTY_KEYS_QUERY_ROOT = 'propKeys' as const

/** Build the TanStack query key for a given `spaceKey`. */
export function propertyKeysQueryKey(
  spaceKey: string = PROPERTY_KEYS_GLOBAL_KEY,
): readonly [typeof PROPERTY_KEYS_QUERY_ROOT, string] {
  return [PROPERTY_KEYS_QUERY_ROOT, spaceKey]
}

/**
 * Backing `queryFn`. Swallows IPC errors to an empty array (matching the
 * old cache, which cached `[]` on failure) so pickers/popovers still render
 * rather than hanging in a loading state forever. The error is logged once
 * per fetch.
 */
export const propertyKeysQueryFn = async (): Promise<string[]> => {
  try {
    return await listPropertyKeys()
  } catch (e) {
    logger.warn('property-keys-cache', 'failed to load property data', undefined, e)
    return []
  }
}

/**
 * Trigger (or join) a single in-flight `listPropertyKeys()` fetch for
 * `spaceKey`. Returns a promise that resolves to the cached array. A cache
 * hit resolves synchronously with the cached value; a second concurrent
 * call before the first resolves shares the same in-flight promise, so two
 * callers fire ONE IPC. After resolution the entry is cached until
 * `invalidatePropertyKeysCache()` (manually or via the materializer event)
 * marks it stale.
 */
export function fetchPropertyKeysOnce(
  spaceKey: string = PROPERTY_KEYS_GLOBAL_KEY,
): Promise<string[]> {
  // `fetchQuery` (not `ensureQueryData`): both give cache-hit reuse and
  // in-flight de-duplication, but `fetchQuery` gates on `isStaleByTime`, which
  // returns true for an invalidated query — so an event-driven
  // `invalidateQueries` is honoured by the very next plain-TS fetch (a refetch),
  // matching the old cache's invalidate→refetch contract. `ensureQueryData`
  // would return the stale cached array instead.
  return queryClient.fetchQuery({
    queryKey: propertyKeysQueryKey(spaceKey),
    queryFn: propertyKeysQueryFn,
  })
}

/**
 * Drop every cached `spaceKey` entry (marks them stale so the next consumer
 * refetches). Exposed for the Tauri listener and for test setup.
 */
export function invalidatePropertyKeysCache(): void {
  void queryClient.invalidateQueries({ queryKey: [PROPERTY_KEYS_QUERY_ROOT] })
}

let targetRegistered = false
let unregisterTarget: (() => void) | null = null

/**
 * Lazily register the materializer-event fan-out target. Process-lifetime —
 * once registered it stays for the rest of the session. The registered
 * callback implements the skip-when-no-new-key strategy (#2507): it reads the
 * union of every currently-cached key list and only invalidates when a
 * `changed_keys` entry is not already known (or the payload is missing).
 */
export function ensurePropertyKeysInvalidationListener(): void {
  if (!targetRegistered) {
    targetRegistered = true
    unregisterTarget = registerPropertyChangeTarget((payload) => {
      if (!payload) {
        void queryClient.invalidateQueries({ queryKey: [PROPERTY_KEYS_QUERY_ROOT] })
        return
      }
      const known = new Set<string>()
      for (const [, keys] of queryClient.getQueriesData<string[]>({
        queryKey: [PROPERTY_KEYS_QUERY_ROOT],
      })) {
        if (keys) for (const k of keys) known.add(k)
      }
      const introducesNewKey = payload.changed_keys.some((key) => !known.has(key))
      if (introducesNewKey) {
        void queryClient.invalidateQueries({ queryKey: [PROPERTY_KEYS_QUERY_ROOT] })
      }
    })
  }
  ensurePropertyChangeDispatch((err) => {
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
 * Test-only reset. Removes every cached entry, unregisters the dispatch
 * target, resets the registered-once flag, and resets the shared dispatcher
 * so each test starts from a clean slate. Imported directly by tests; not
 * part of the public surface.
 */
export function _resetPropertyKeysCacheForTest(): void {
  queryClient.removeQueries({ queryKey: [PROPERTY_KEYS_QUERY_ROOT] })
  if (unregisterTarget) {
    unregisterTarget()
    unregisterTarget = null
  }
  targetRegistered = false
  _resetPropertyChangeDispatchForTest()
}
