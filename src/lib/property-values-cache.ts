/**
 * property-values-cache — TanStack Query-backed cache for
 * `listPropertyValues(key)` results, keyed on the property `key`.
 *
 * #1425: powers the property-VALUE autocomplete (the value side of a
 * `prop:key=value` editor). #2596 (pilot proof-point 1): the hand-rolled
 * module-level cache (Map / in-flight dedup / subscriber set / epoch
 * race-guard) is gone — TanStack Query's module-level `queryClient`
 * singleton now provides cache-hit reuse and in-flight de-duplication for
 * free. This module keeps the historical public export names.
 *
 * Invalidation follows the `block:properties-changed` convention, fanned out
 * through the single module-level dispatcher (`property-change-dispatch.ts`).
 * The value cache uses PER-CHANGED-KEY eviction (#2507): the cache is keyed on
 * the property *key*, and a write's `changed_keys` are exactly the cache keys
 * that went stale — so a change to `project` only evicts `project`'s value
 * list, never `effort`'s.
 */

import { EVENT_PROPERTY_CHANGED } from '@/lib/block-event-names'
import { logger } from '@/lib/logger'
import {
  _resetPropertyChangeDispatchForTest,
  ensurePropertyChangeDispatch,
  registerPropertyChangeTarget,
} from '@/lib/property-change-dispatch'
import { queryClient } from '@/lib/query-client'
import { listPropertyValues } from '@/lib/tauri'

export { EVENT_PROPERTY_CHANGED }

/** Stable empty-array reference returned by consumers before the first fetch
 *  resolves. Reusing this constant keeps snapshots referentially stable so
 *  React consumers relying on identity don't thrash. */
export const PROPERTY_VALUES_EMPTY: string[] = []

/** Query-key root shared by every key-scoped property-values entry. */
const PROPERTY_VALUES_QUERY_ROOT = 'propValues' as const

/** Build the TanStack query key for a given property `key`. */
export function propertyValuesQueryKey(
  key: string,
): readonly [typeof PROPERTY_VALUES_QUERY_ROOT, string] {
  return [PROPERTY_VALUES_QUERY_ROOT, key]
}

/**
 * Backing `queryFn` for a property `key`. Swallows IPC errors to an empty
 * array (matching the old cache) so the value popover still renders rather
 * than hanging in a loading state forever.
 */
export const propertyValuesQueryFn = async (key: string): Promise<string[]> => {
  try {
    return await listPropertyValues(key)
  } catch (e) {
    logger.warn('property-values-cache', 'failed to load property data', { key }, e)
    return []
  }
}

/**
 * Trigger (or join) a single in-flight `listPropertyValues(key)` fetch.
 * Returns a promise that resolves to the cached array. A cache hit resolves
 * synchronously; two concurrent calls share one in-flight promise, so they
 * fire ONE IPC. After resolution the entry is cached until
 * `invalidatePropertyValuesCache()` (manually or via the materializer event)
 * marks it stale.
 */
export function fetchPropertyValuesOnce(key: string): Promise<string[]> {
  // `fetchQuery` (not `ensureQueryData`): both give cache-hit reuse and
  // in-flight de-duplication, but `fetchQuery` gates on `isStaleByTime`, which
  // returns true for an invalidated query — so a per-key `invalidateQueries` is
  // honoured by the next plain-TS fetch (a refetch), matching the old cache's
  // invalidate→refetch contract. `ensureQueryData` would return the stale array.
  return queryClient.fetchQuery({
    queryKey: propertyValuesQueryKey(key),
    queryFn: () => propertyValuesQueryFn(key),
  })
}

/**
 * Drop every cached `key` entry (marks them stale so the next consumer
 * refetches). Exposed for the Tauri listener and for test setup.
 */
export function invalidatePropertyValuesCache(): void {
  void queryClient.invalidateQueries({ queryKey: [PROPERTY_VALUES_QUERY_ROOT] })
}

let targetRegistered = false
let unregisterTarget: (() => void) | null = null

/**
 * Lazily register the materializer-event fan-out target. Process-lifetime —
 * once registered it stays for the rest of the session. The registered
 * callback evicts only the changed keys (#2507); a payload-less event falls
 * back to a blanket clear.
 */
export function ensurePropertyValuesInvalidationListener(): void {
  if (!targetRegistered) {
    targetRegistered = true
    unregisterTarget = registerPropertyChangeTarget((payload) => {
      if (!payload) {
        void queryClient.invalidateQueries({ queryKey: [PROPERTY_VALUES_QUERY_ROOT] })
        return
      }
      payload.changed_keys.forEach((key) => {
        void queryClient.invalidateQueries({ queryKey: propertyValuesQueryKey(key) })
      })
    })
  }
  ensurePropertyChangeDispatch((err) => {
    logger.warn(
      'property-values-cache',
      'failed to register property-change listener',
      undefined,
      err,
    )
  })
}

/**
 * Test-only reset. Removes every cached entry, unregisters the dispatch
 * target, resets the registered-once flag, and resets the shared dispatcher
 * so each test starts from a clean slate. Imported directly by tests; not
 * part of the public surface.
 */
export function _resetPropertyValuesCacheForTest(): void {
  queryClient.removeQueries({ queryKey: [PROPERTY_VALUES_QUERY_ROOT] })
  if (unregisterTarget) {
    unregisterTarget()
    unregisterTarget = null
  }
  targetRegistered = false
  _resetPropertyChangeDispatchForTest()
}
